# E3 Agent Harness decision record

Date: 2026-09-01

## Architecture

The E3 Agent Harness uses a deterministic-first route:

1. Validate the authenticated request.
2. Match a bounded workflow from one of eight read-only business Skills.
3. Query the live business source and render a deterministic answer.
4. Send unmatched/open-ended questions, authorised knowledge questions and image turns to Kimi K2.6.
5. Fail closed when Kimi or a required live source fails; do not generate an alternate-model or local-summary answer.
6. Emit a privacy-safe local structured diagnostic record with route/tool names, status and duration. Raw ERP prompts, answers, tool payloads and image/base64 content are not logged.

Demo data is not a production fallback. Inventory defaults to the Inventory Operations API. Quotations defaults to the authenticated QuoteHelp session, or to `ERP_QUOTATION_API_URL` when explicitly configured.

## API and model decision

Decision: keep the small application-owned Chat Completions adapter and use only `kimi-k2.6`. China keys map to `https://api.moonshot.cn/v1`, International keys map to `https://api.moonshot.ai/v1`, and arbitrary endpoints are rejected. Kimi thinking is disabled for this rollout, tool schemas follow Moonshot's strict MFJS subset, and current-turn JPEG/PNG/WebP images are sent as base64 `image_url` content parts.

Rationale:

- The highest-value E3 queries remain deterministic; Kimi handles visual input, grounded knowledge synthesis and unmatched requests without replacing those factual workflows.
- Kimi K2.6 supports the required multimodal content, strict tool calls and JSON Mode through the existing Chat Completions shape: [Kimi K2.6 quickstart](https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart) and [Chat API](https://platform.kimi.ai/docs/api/chat).
- Application-owned orchestration preserves server-side authorisation, strict tool-result validation, bounded payloads and fail-closed grounding.
- A larger SDK is unnecessary until managed state, handoffs or guardrails measurably remove code or improve reliability.

## Re-evaluation gate

Run `npm run eval:agent` against a signed-in staging or production-like deployment and collect at least 100 representative requests. Reconsider the runtime or model only after measuring:

- deterministic workflow match rate and task success;
- live-source and tool error rate;
- model fallback rate;
- factual correctness and required-field completeness;
- p50/p95 latency;
- tokens and cost per successful open-ended task.

Before production promotion, run `npm run spike:kimi` with the intended Moonshot account and pass ordinary chat, JSON Mode, strict tools, image/tool input, multi-round completion, streaming, timeout and structured-error checks. Then run one-variable-at-a-time prompt/tool-policy comparisons while keeping the fixed Kimi model and deterministic workflows unchanged.
