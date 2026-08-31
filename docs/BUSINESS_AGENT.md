# Read-only ERP Business Agent

Date: 2026-08-27

## Repository audit and architecture decision

This repository is a Next.js 16 / React 19 / strict TypeScript application deployed to Cloudflare Workers through OpenNext. Employee authentication uses a signed, HttpOnly `e3_erp_session` cookie. D1 stores application records and employee accounts; KV stores protected file blobs. Existing Inventory and QuoteHelp integrations are bounded server-side HTTP providers. Tests use Node's built-in test runner, and deployment is driven by `wrangler.jsonc` plus the scripts in `package.json`.

No `AGENTS.md` exists in this repository. The files found in sibling repositories do not apply here.

The new service is an independent module inside the existing application:

```text
POST /api/agent/chat
  -> signed ERP session / server-injected permissions
  -> deterministic Flash/Pro router
  -> thin DeepSeek Chat Completions loop
  -> four strict, read-only tools
  -> same-Worker knowledge retrieval plus bounded ERP service adapters
  -> existing Files/D1/Workers AI/Vectorize and upstream business services
```

The model never opens D1 or another database, cannot execute SQL, and has no write tool. Inventory delegates to the existing `ERPProvider`. Knowledge uses the same-Worker `searchKnowledgeBase` service, which maps Vectorize candidates back to authorised D1 chunks and protected Files metadata before any excerpt enters model context. Project snapshot and order finance retain authenticated HTTP adapters. Every result is field-allow-listed and failures remain fail-closed.

## DeepSeek transport and compatibility spike

Decision: use a small application-owned Chat Completions loop. Do not use Responses API or the OpenAI Agents SDK for this version.

DeepSeek's official documentation, checked on 2026-08-27, says:

- both `deepseek-v4-flash` and `deepseek-v4-pro` support OpenAI-format Chat Completions and tool calls;
- Responses API supports Flash but not Pro, so it cannot be the common transport;
- streaming uses SSE and can include usage in a final usage chunk;
- strict tool schema support is Beta and the tool guide requires the `/beta` base URL;
- thinking-mode tool calls must retain `reasoning_content` in the intermediate assistant message.

Sources: [Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/), [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/), [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/), [Models and Pricing](https://api-docs.deepseek.com/quick_start/pricing/).

The local transport contract tests pass tool call → tool result → validated JSON answer, usage parsing, strict client-side validation, and cached tool-result reuse. A live API key was not available in the implementation environment, so no live model claim is fabricated. Run the complete live spike for both models:

```bash
DEEPSEEK_API_KEY=... npm run spike:deepseek
# Optional private report (do not commit it):
DEEPSEEK_API_KEY=... npm run spike:deepseek -- --output=/tmp/deepseek-spike.json
```

The script checks ordinary chat, a forced strict-schema call, multi-round tool result completion, SSE, usage, client timeout, and structured API errors for both configured models. Promote the service only after every live check passes against the intended DeepSeek account and region.

Administrators may configure the key without editing environment files under **Settings → Agent Settings → DeepSeek Business Agent**. The key is stored only in the existing protected server settings document (private `0600` local file or Cloudflare D1), is returned to the browser only as a last-four-character mask, and takes precedence over `DEEPSEEK_*` environment variables. Leaving the field blank retains the existing key.

## Routing

`deepseek-v4-flash` is the baseline for one-domain/simple requests. `deepseek-v4-pro` is selected before the first model call when at least two domains are detected or a named customer/order/project finance eligibility judgement is requested. Flash escalates at most once when a tool reports policy conflict/incomplete data, final JSON fails validation, or the tool-round limit is reached. Tool results are cached by canonical tool name and arguments and reused by Pro.

Missing SKU, project ID, or order number produces a clarification response without a model call. Model names and endpoints exist only in `resolveDeepSeekConfig`, not in business tools.

## Tool contracts

Every model tool sets `strict: true`, disallows additional properties, has bounded strings/lists, and returns:

```json
{
  "ok": true,
  "data": {},
  "error_code": null,
  "source": "inventory_service",
  "source_record_ids": ["record-id"],
  "updated_at": "2026-08-27T00:00:00Z",
  "retryable": false
}
```

Errors distinguish `invalid_input`, `permission_denied`, `not_found`, `unknown`, `unavailable`, `timeout`, and `incomplete_data`. Tool definitions are in `src/lib/business-agent/tools.ts`:

- `get_inventory(sku, warehouse_id?)` — exact SKU only; returns `on_hand`, `reserved`, `available`, `incoming`, and freshness exactly as supplied by ERP. `incoming: null` means the current upstream contract does not expose it.
- `search_knowledge_base(query, product?, region?, effective_date?, limit)` — at most eight server-authorised document chunks with citation metadata. Tenant, role, permissions and access scope come only from the signed session; retrieved text is treated as untrusted data.
- `get_project_snapshot(project_id)` — project, milestones, dates, budget summary, risks, related orders, and an upstream deterministic health basis.
- `get_order_finance_details(order_no)` — separates actual application, enumerated application status, and possible eligibility for loans and subsidies. `unknown` remains unknown.

## Permission matrix

Permissions are derived only from the signed server session. The current application is single-tenant, so the server injects tenant `e3`; request/model fields cannot replace it.

| Role | inventory.read | knowledge.read | project.read | order.read | finance.read | subsidy.read |
| --- | --- | --- | --- | --- | --- | --- |
| Administrator | Yes | Yes | Yes | Yes | Yes | Yes |
| Project Manager | Yes | Yes | Yes | Yes | No | Yes |
| Sales / Specialist | Yes | Yes | Yes | Yes | No | No |

The combined order-finance tool requires `order.read`, `finance.read`, and `subsidy.read`; unauthorised roles are blocked before an upstream call. Internal HTTP calls carry the server-to-server bearer token plus server-derived tenant, role, and permission headers. The upstream ERP service must independently enforce those fields and tenant ownership.

## API

Request:

```json
{ "message": "Show inventory for SKU INV-100", "conversation_id": "browser-thread-1" }
```

The request accepts no `user_id`, tenant, role, permission, or arbitrary history fields. Response:

```json
{
  "answer": "...",
  "citations": [],
  "model_used": "deepseek-v4-flash",
  "route": "flash",
  "tool_calls_summary": [{ "name": "get_inventory", "status": "ok", "cached": false }],
  "request_id": "...",
  "data_updated_at": "...",
  "limitations": []
}
```

The response never includes chain of thought. Logs contain an opaque principal hash, request ID, route/model, tool names/status, latency, escalation, token counts when supplied, and final status. They exclude user text, tool payloads, model payloads, cookies, bearer tokens, and personal details.

## Data sources

Inventory is already available through `ERPProvider`. Knowledge is implemented inside this Worker and requires the private `AI` and `KNOWLEDGE_VECTORS` bindings plus D1 migration `0005_knowledge_base.sql`; it does not require a public URL or bearer-token self-call. `ERP_KNOWLEDGE_API_URL` remains only as a legacy/injected adapter fallback for isolated provider tests. The remaining optional external vertical slices are:

| Setting | Required endpoint and fields |
| --- | --- |
| `ERP_PROJECT_API_URL` | `GET projects/:id/snapshot`; progress, milestones, estimated completion, budget summary, risks, related orders, deterministic health status and basis |
| `ERP_ORDER_API_URL` | `GET orders/:no/finance`; customer-visible order state and project link; loan/subsidy `actually_applied`, enumerated status, possible eligibility and basis |

Do not add a shadow policy or inventory table. Structured ERP data continues through its repositories/tools; only unstructured Files knowledge is indexed. Fake search providers are used only in tests.

## Limits and rollout

- request body: 16 KiB; message: 2,000 characters; tool arguments: 8 KiB;
- four tool rounds, four calls per round, eight retrieval chunks, 1,200 output tokens;
- individual model call: 35 seconds; total request: 55 seconds; one Flash → Pro escalation;
- upstream tool timeout: 8 seconds; model response: 2 MiB; tool result in model context: 64 KiB;
- no retries in v1; retryable tool failures are explicit.

Suggested rollout: enable in development with fake upstream contract tests; pass the live DeepSeek spike; deploy to a staff-only staging cohort; run the eval set and review permission logs; then enable inventory first, knowledge next, and project/order only after their APIs and ACL tests are complete.

Known limitations:

- the current ERP session has no organisation/department/data-scope claims and is single-tenant; multi-tenant rollout requires signed claims and upstream enforcement before enablement;
- the current Inventory service does not expose `incoming`, so it is returned as unknown (`null`), never inferred;
- live DeepSeek compatibility remains a deployment gate because no API key was available here;
- project and order external snapshot APIs remain optional/unimplemented in this repository; knowledge retrieval is local to the Worker;
- the durable Cloudflare Workflow indexer accepts at most 256 application chunks per document, embeds eight at a time, and requires Administrator **Vectorize again** after a terminal provider failure; larger manuals must be split before indexing.

## Verification

```bash
npm ci
npm run typecheck
npm test
npm run build
```

The repeatable scenario dataset is `evals/business-agent.json`. It scores route/tool/arguments, structured facts, citations, permission blocks, and abstention independently rather than exact answer text.

Run live structural evals against a signed-in deployment (add role cookies to exercise the permission matrix):

```bash
E3_EVAL_BASE_URL=http://localhost:3000 \
E3_EVAL_COOKIE='admin session cookie' \
E3_EVAL_SALES_COOKIE='sales session cookie' \
E3_EVAL_PM_COOKIE='project manager session cookie' \
E3_EVAL_REQUIRE_LIVE=1 \
npm run eval:business-agent
```
