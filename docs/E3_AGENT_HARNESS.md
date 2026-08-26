# E3 Agent Harness decision record

Date: 2026-08-25

## Architecture

The E3 Agent Harness uses a deterministic-first route:

1. Validate the authenticated request.
2. Match a bounded workflow from one of seven read-only business Skills.
3. Query the live business source and render a deterministic answer.
4. Use the configured OpenAI-compatible model only for unmatched, open-ended questions.
5. Fall back to bounded local summaries when the model endpoint fails.
6. Emit a privacy-safe trace with route names, status and duration only.

Demo data is not a production fallback. Inventory defaults to the Inventory Operations API. Quotations defaults to the authenticated QuoteHelp session, or to `ERP_QUOTATION_API_URL` when explicitly configured.

## API and model decision

Decision: keep the current OpenAI-compatible Chat Completions adapter and `qwen3.5:9b` baseline for now. Do not migrate the production path to Responses API or Agents SDK until the seven live business evals have a stable baseline.

Rationale:

- The highest-value E3 queries are now deterministic, so a stronger model cannot improve their factual computation.
- The current endpoint is OpenAI-compatible Ollama. Responses API or Agents SDK adoption would also change the provider/runtime, making it harder to attribute quality, latency and cost changes.
- The official OpenAI guidance recommends Responses API for reasoning, tool-calling and multi-turn workflows, and recommends comparing model/reasoning configurations on representative tasks rather than assuming a stronger setting is better: [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model).
- Agents SDK becomes attractive when E3 needs SDK-managed orchestration, state, handoffs, guardrails or richer tracing. The current seven workflows are small and intentionally application-owned.

## Re-evaluation gate

Run `npm run eval:agent` against a signed-in staging or production-like deployment and collect at least 100 representative requests. Reconsider the runtime or model only after measuring:

- deterministic workflow match rate and task success;
- live-source and tool error rate;
- model fallback rate;
- factual correctness and required-field completeness;
- p50/p95 latency;
- tokens and cost per successful open-ended task.

Then run one-variable-at-a-time comparisons:

1. Current adapter + current model (baseline).
2. Current adapter + candidate stronger model.
3. Responses API + the same candidate model.
4. Agents SDK only if its managed orchestration features remove code or improve measured reliability.

For an OpenAI pilot, start with a balanced model configuration for open-ended queries and retain deterministic workflows unchanged. Promote a candidate only when its eval gain justifies its latency and cost.
