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
   Deploy command: npx wrangler deploy
   ```

6. Deploy first to the generated `*.workers.dev` address and verify Inventory and QuoteHelp login/session behavior before attaching the production domain.

The Worker name is `e3-erp`. The upstream Inventory, QuoteHelp and Agent model host/model settings are already declared as non-secret runtime variables in `wrangler.jsonc`.

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

The eight employee accounts are built in as usernames, roles and salted password verifiers. Plain-text passwords are not stored in Git. Do not put real secrets in `wrangler.jsonc`, `.env.example`, or `.dev.vars.example`.

Before exposing the login page publicly, add a Cloudflare WAF rate-limit rule for `POST /api/auth/login`. The application also applies bounded per-IP and per-account protection, but Worker instances do not share in-memory counters; the Cloudflare rule provides the deployment-wide limit.

## Local verification

```bash
npm ci
npm run typecheck
npm run cf:build
npm run preview
```

`npm run preview` runs the OpenNext production bundle in the Workers runtime. Regular application development still uses `npm run dev`.

## Current storage limitation

Inventory and QuoteHelp continue to save to their existing upstream services, so those two modules retain their data after deployment.

The modules below currently use the local `.data` filesystem:

- Site Visiting records and photos
- Payment Track records, contracts and proof files
- Reimbursements records and invoices
- Project Schedule
- Reports
- Group Chat
- Public Announcements
- Saved Agent settings

Cloudflare Workers only provides an ephemeral in-memory filesystem. These file-backed routes are **not production-functional on Workers yet**: reads can fail and writes cannot persist across requests or deployments. Before enabling them in the Cloudflare deployment, move structured records to D1 and uploaded files to R2. Keep API keys in Cloudflare Secrets rather than saved Agent settings.

## CLI deployment alternative

After authenticating Wrangler locally:

```bash
npx wrangler login
npx wrangler secret put ERP_AUTH_SESSION_SECRET
npm run deploy
```

Add encrypted values with `npx wrangler secret put NAME`; never commit the resulting secret values.
