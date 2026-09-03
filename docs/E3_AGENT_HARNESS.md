# E3 Agent Harness decision record

Date: 2026-09-04

## Architecture

The E3 Agent Harness uses a deterministic-first route:

1. Validate the authenticated request.
2. Resolve an exact personal Skill or an explicit current-turn request to create one.
3. Apply the environment Skill allow-list, then match a bounded deterministic workflow.
4. Query the live business source and render a deterministic answer.
5. Send unmatched/open-ended questions, authorised knowledge questions and image turns to Kimi K2.6.
6. Fail closed when Kimi or a required live source fails; do not generate an alternate-model or local-summary answer.
7. Emit a privacy-safe local structured diagnostic record with route/tool names, status and duration. Raw ERP prompts, answers, Skill proposals, tool payloads and image/base64 content are not logged.

## Bounded Hermes-inspired architecture

E3 keeps its application-owned security and deterministic core. It adopts the useful structural ideas without adopting a general autonomous runtime:

- **Tool Registry:** every Kimi tool has one registration containing its source-controlled Skill, Toolset, read-only flag and data classification. Site Visiting has its own privacy-gated read tool, and unregistered or disabled tools fail closed.
- **Toolsets:** each turn exposes only the tools selected for the relevant ERP domain. Knowledge-only turns expose only knowledge search; image-only turns cannot call knowledge search unless the user asks for it.
- **Layered Prompt:** `e3-agent-v2.2` builds stable identity, grounding/security, knowledge, domain, presentation and dynamic context in a fixed order.
- **Controlled Skills:** source-controlled business capabilities and tools remain versioned, read-only and immutable at runtime. A user may explicitly ask the Personal Skill Builder to create one manually triggered personal workflow. Kimi produces only a bounded proposal from the current message; the server rejects extra fields, credentials, external destinations and unsafe mutations, applies the fixed capability allow-list, derives ownership from the signed session and persists the Skill before reporting success. A stable client request ID makes creation idempotent across retries. The proposal model never receives a storage owner, permissions, attachments, ERP results or a write tool. Custom Skills must observe at least one verified authorised tool result before returning workspace claims. `E3_AGENT_ENABLED_SKILLS` can only narrow the runtime allow-list, and user permissions are still enforced for every tool call.
- **Controlled Memory:** conversation memory is ephemeral and contains only explicit response-language, detail-level and table-format preferences. It never stores business facts, identifiers, permissions or personal information and is never an evidence source.
- **Trajectory evaluation:** traces contain workflow, Skill, Toolset, tool status/duration, model rounds, token counts and abstention state. They contain no raw prompts, answers, tool arguments or results.

The current scope is E3 question answering, authorised knowledge retrieval, Project Management, Project Track, Weekly Schedule, Inventory, Quotations, Site Visits, Reimbursements, Reports, Communications and explicitly requested personal Skill configuration. Multi-platform messaging, shell/code execution, autonomous long-running tasks, scheduled/background Skills and model-initiated ERP writes remain intentionally excluded.

Langfuse remains paused. The local privacy-safe trajectory is the evaluation source until a later explicit decision re-enables external tracing.

Demo data is not a production fallback. Inventory defaults to the Inventory Operations API. Quotations defaults to the authenticated QuoteHelp session, or to `ERP_QUOTATION_API_URL` when explicitly configured.

## API and model decision

Decision: keep the small application-owned Chat Completions adapter and use only `kimi-k2.6`. China keys map to `https://api.moonshot.cn/v1`, International keys map to `https://api.moonshot.ai/v1`, and arbitrary endpoints are rejected. Kimi thinking is disabled for this rollout, tool schemas follow Moonshot's strict MFJS subset, and current-turn JPEG/PNG/WebP images are sent as base64 `image_url` content parts.

Rationale:

- The highest-value E3 queries remain deterministic; Kimi handles visual input, grounded knowledge synthesis and unmatched requests without replacing those factual workflows.
- Kimi K2.6 supports the required multimodal content, strict tool calls and JSON Mode through the existing Chat Completions shape: [Kimi K2.6 quickstart](https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart) and [Chat API](https://platform.kimi.ai/docs/api/chat).
- Application-owned orchestration preserves server-side authorisation, strict tool-result validation, bounded payloads and fail-closed grounding.
- A larger SDK is unnecessary until managed state, handoffs or guardrails measurably remove code or improve reliability.

## Re-evaluation gate

Run `npm run eval:agent` against a signed-in staging or production-like deployment and collect at least 100 representative requests. The runner checks workflow, Skill/Toolset route and abstention behaviour, then reports trajectory p50/p95 latency and model tokens. Reconsider the runtime or model only after measuring:

- deterministic workflow match rate and task success;
- live-source and tool error rate;
- model fallback rate;
- factual correctness and required-field completeness;
- p50/p95 latency;
- tokens and cost per successful open-ended task.

Use one-variable-at-a-time comparisons: keep the dataset and deterministic workflows fixed, change one prompt/tool-routing policy, and compare task correctness, grounded abstention, latency and token use before promotion.

Before production promotion, run `npm run spike:kimi` with the intended Moonshot account and pass ordinary chat, JSON Mode, strict tools, image/tool input, multi-round completion, streaming, timeout and structured-error checks. Then run one-variable-at-a-time prompt/tool-policy comparisons while keeping the fixed Kimi model and deterministic workflows unchanged.
