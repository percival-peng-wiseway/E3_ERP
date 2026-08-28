# Cloudflare Workers deployment

This repository is configured for full-stack Next.js deployment to Cloudflare Workers through OpenNext.

## Fastest deployment from GitHub

1. In Cloudflare, open **Workers & Pages** and choose **Create application** / **Import a repository**.
2. Connect GitHub and select `percival-peng-wiseway/E3_ERP`.
3. Use the repository root as the root directory.
4. Use Node.js 22 or a current Node.js 20 release.
5. If Cloudflare presents one deployment-command field, use:

   ```bash
   npm run deploy
   ```

   If it presents separate build and deploy fields, use:

   ```text
   Build command:  npm run cf:build
   Deploy command: npm run cf:deploy-built
   ```

   `cf:deploy-built` applies pending D1 migrations before deploying the existing OpenNext build output. Do not use a raw `wrangler deploy` or `opennextjs-cloudflare deploy` command for production releases because those commands bypass the repository's migration guard.

6. Deploy first to the generated `*.workers.dev` address and verify Inventory and QuoteHelp login/session behavior before attaching the production domain.

The Worker name is `e3-erp`. The upstream Inventory, QuoteHelp and Agent model host/model settings are already declared as non-secret runtime variables in `wrangler.jsonc`.

The knowledge base also requires a private Cloudflare AI Search built-in-storage instance named `erp`. Its direct Worker binding is `KNOWLEDGE_SEARCH`; it is not an HTTP endpoint and needs no browser or DeepSeek secret. Create and configure it before building or deploying a Worker version containing that binding. The exact verified command, five-field metadata schema and open-beta cost caveat are documented in [docs/KNOWLEDGE_BASE.md](./docs/KNOWLEDGE_BASE.md). Confirm the Cloudflare account plan and Workers AI budget before creating it.

## Required production secrets

Add these under the Worker's **Settings → Variables and Secrets**. Mark every value as encrypted/secret.

| Name | Required for | Value |
| --- | --- | --- |
| `ERP_AUTH_SESSION_SECRET` | Employee login and signed sessions | At least 32 random characters; required |
| `REIMBURSEMENT_ADMIN_PASSWORD` | Legacy standalone administration login | Optional when ERP administrator accounts are used |
| `REIMBURSEMENT_SESSION_SECRET` | Legacy standalone administrator sessions | Optional when ERP administrator accounts are used |
| `AGENT_API_KEY` | E3 Agent | Optional; the current Ollama/ngrok endpoint does not require a key |
| `ERP_INTERNAL_API_TOKEN` | Trusted non-browser API writes | A long random token; optional for browser-only use |

Optional read-only dashboard/Agent data sources:

- `ERP_INVENTORY_API_URL`
- `ERP_QUOTATION_API_URL`
- `ERP_API_TOKEN`

The initial employee accounts are seeded into `ERP_DB` by migration, and subsequent account, role, status and password changes are made under **Settings → User Management**. Only salted scrypt password verifiers are stored; plain-text passwords are not retained. Do not put real secrets in `wrangler.jsonc`, `.env.example`, or `.dev.vars.example`.

Before exposing the login page publicly, add a Cloudflare WAF rate-limit rule for `POST /api/auth/login`. The application also applies bounded per-IP and per-account protection, but Worker instances do not share in-memory counters; the Cloudflare rule provides the deployment-wide limit.

## Local verification

```bash
npm ci
npm run typecheck
npm run cf:build
npm run preview
```

`npm run preview` runs the OpenNext production bundle in the Workers runtime. Regular application development still uses `npm run dev`.
Because `KNOWLEDGE_SEARCH` uses `remote: true`, both preview and the OpenNext Cloudflare build resolve the real account resource; they fail closed when `erp` has not been created. Node unit/integration tests inject a bounded fake provider and do not substitute a second production retrieval system.

## Production storage

Inventory and QuoteHelp continue to save to their existing upstream services, so those two modules retain their data after deployment.

Worker-hosted business modules use the resources declared in `wrangler.jsonc`:

- `ERP_DB` (D1) stores the normalized employee directory and Files metadata plus versioned Project Track, Project Schedule, Site Visiting, Reimbursements, Reports, Group Chat, Public Announcements and saved Agent-settings documents. Employee rows carry audit fields, optimistic row versions and session versions; changing an account invalidates its earlier signed sessions. Files item mutations use row versions, while document updates use compare-and-swap retries, so separate Worker isolates cannot silently overwrite one another.
- `ERP_FILES` (private Workers KV) stores Files blobs plus immutable Project Track contracts/payment proofs, Site Visiting photos and Reimbursement invoices. Files downloads require an ERP session; workflow attachments retain their per-file access controls.
- `KNOWLEDGE_SEARCH` (Cloudflare AI Search built-in Items storage) stores disposable, pre-chunked Markdown search items. Files remains authoritative in `ERP_DB` + `ERP_FILES`; D1 migration `0005_knowledge_base.sql` stores document metadata, chunk locators/text, active generations and leased index jobs. AI Search performs hybrid vector/BM25 retrieval and reranking only; DeepSeek remains the only answer generator.
- Local development continues to use the corresponding `.data` files, so Node-based development and focused repository tests do not need Cloudflare bindings.

Apply D1 migrations manually when needed with the same reusable command used by the deployment hooks:

```bash
npm run cf:migrate
```

`npm run deploy` runs this migration automatically through its `predeploy` hook before building and deploying. `npm run upload` does the same through `preupload`. For platforms that build and deploy in separate steps, use `npm run cf:build` followed by `npm run cf:deploy-built`; the latter migrates once and deploys the already-built artifact without recursively invoking the normal deploy hook.

Knowledge deployment order is: create `erp`, generate/check binding types with `npm run cf-typegen`, apply migration `0005`, build, then deploy. Rolling the application back does not require deleting Files or AI Search Items; leave the D1 tables intact and follow the disable/rollback procedure in the knowledge-base runbook.

To import existing local Project Track, Project Schedule and Site Visiting data without placing customer records or files in Git, run this once after reviewing the destination Cloudflare account:

```bash
npm run cf:migrate-local-data -- --confirm-sensitive-upload
```

The import stops before uploading when any destination D1 document already exists. Referenced private files receive fresh immutable object keys before they are uploaded to `ERP_FILES`.

The migration command intentionally covers Project Track, Project Schedule and Site Visiting only. Reimbursement records/invoices and other local documents can contain additional private employee data and must not be uploaded without a separate review and explicit approval. New production records in those modules are persisted automatically.

Prefer the `AGENT_API_KEY` Cloudflare Secret for long-lived Agent credentials. The settings UI can save a replacement server-side, but local Agent settings—including any existing key—are never copied by the migration script.

Most structured modules currently use one bounded, versioned D1 document. Files instead uses normalized D1 rows with a 5,000-item guard, 1 GiB workspace quota, 250 MiB per-owner quota and a 20 MiB per-file limit. Private KV objects use random immutable keys. Because a new KV key can take time to reach another Cloudflare location, file reads return a retryable syncing response while the object propagates. R2 remains the preferred future backend for larger files and immediate cross-region read-after-write once it is enabled for the Cloudflare account.

## CLI deployment alternative

After authenticating Wrangler locally:

```bash
npx wrangler login
npx wrangler secret put ERP_AUTH_SESSION_SECRET
npm run deploy
```

Add encrypted values with `npx wrangler secret put NAME`; never commit the resulting secret values.
