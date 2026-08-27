<p align="center">
  <img src="src/assets/e3-energy-app-icon.png" alt="E3 Energy" width="128" />
</p>

# E3 ERP

An ERPNext-inspired operations workspace that brings shared Files, Inventory, QuoteHelp, Project Track delivery and payment workflows, and employee reimbursements into one native interface.

The application no longer uses iframes. The browser calls same-origin ERP APIs, and controlled server-side proxies connect to the existing Inventory and QuoteHelp services. Existing data, accounts and business rules remain in use.

Employee access is protected by a unified ERP sign-in. The server issues a signed, HttpOnly session cookie and keeps salted password verifiers out of the browser bundle. Employee accounts are managed in Cloudflare D1 with Administrator, Project Manager and Sales roles; authenticated administrators inherit the protected Reimbursements and Project Track administration permissions.

## Current modules

### Files

- Shared company file space for every signed-in employee, with folders, breadcrumbs, search and sorting
- Create folders and upload PDF, image, text, CSV, Word, Excel and PowerPoint files up to 20 MiB each
- Drag-and-drop and multi-file upload queue, safe image/PDF preview and protected downloads
- Creators can rename, move, trash and restore their own items; Administrators can manage all items and permanently purge Trash
- D1-backed directory metadata provides optimistic concurrency, duplicate-name protection, quotas and cycle-safe folder moves

### Home and Agent

- Home shows role-specific action reminders and Admin-managed public announcements on the left, with E3 Agent on the right
- Sales reminders are limited to actionable Project Track collections; PM receives only delivery and installation scheduling reminders; Admin receives submitted payment confirmations and reimbursement actions
- The E3 Agent Harness answers questions across seven bounded, read-only business Skills: Inventory, Quotations, Project Management, Project Track, Site Visiting, Reimbursements and Reports
- Common operational queries use deterministic workflows before any model call; open-ended questions use the configured OpenAI-compatible endpoint
- Each request emits a privacy-safe trace containing only workflow/tool names, status and duration
- `qwen3.5:9b` is the default model; the other models advertised by the endpoint can be selected from Settings
- The current endpoint does not require an API key; an optional key remains supported for future compatible endpoints
- If the endpoint is unavailable, deterministic workflows and basic local summaries remain available
- Payment proof URLs, reimbursement invoice URLs, access tokens, cookies and API keys are never included in model tool results
- A separately deployable read-only Business Agent endpoint at `POST /api/agent/chat` adds strict inventory, knowledge, project and order-finance tools with deterministic DeepSeek Flash/Pro routing; see [docs/BUSINESS_AGENT.md](./docs/BUSINESS_AGENT.md)

### Inventory

- Inventory overview, search, categories, status filters and sorting
- Multi-item sales orders that enter Pending PM Review
- Stock receipt parsing and inventory updates
- Completed delivery and stock loss history
- Administrator item editing, stock loss and deletion
- Role-aware controls: Sales/Admin can create orders, while stock intake and Inventory Admin controls are Administrator-only

### Quotations

- Residential and C&I quotations
- FOX and SIG products with multiple PV, inverter and battery configurations
- Customer details, costs, margins, STCs, rebates, loans and discounts
- Live margin calculations, approval status, save, save as and reset
- Team quotation search, owner, status and date filters
- Product catalogues, user permissions and administrator operations
- Single and bulk Excel export and import

### Project Management

- ERPNext-style delivery Kanban
- Weekly Schedule combines Project Track material deliveries and Inventory dispatches under one Material Delivery view
- Site Visiting requests with a confirmed visit date and time appear automatically in Weekly Schedule
- Four stages: Pending PM Review, Scheduled, Today and Delivered
- A task appears automatically in Pending PM Review when New Order is submitted in Inventory
- PM users assign the address, date, driver and driver email before scheduling delivery
- Schedule updates continue to use the existing Inventory driver-notification workflow
- Search by customer, address, SKU, sales representative or driver, with driver filtering
- Drag tasks to reschedule them; confirming delivery updates inventory

### Site Visiting

- Submit a site visit request with the customer name, address, phone, reason and preferred date/time
- Move requests through Pending Approval, Approved, Scheduled, In Progress and Completed, with Admin approval and PM/Admin scheduling
- Keep the preferred time separate from the confirmed visit time and assigned team member
- Record an extensible on-site checklist covering roof tiles, switchboard replacement, AC cable run, roof material, BAT location, fire cement sheet, sub-switchboard, switch upgrade, backup circuit and concrete slab
- Add checklist notes, general site notes and multiple photos from a phone camera or photo library
- Open the focused detail view from the whole mobile-first card, with the current workflow stage visible on every card

### Reimbursements

- Employees submit an AUD amount, expense details and a PDF or image invoice
- New claims enter Admin Review
- Approved claims move to Pending Payment; rejected claims retain the review reason
- Admin records the payment reference and moves paid claims to Reimbursed
- Every claim includes an invoice link and status history
- Claims are private to the submitting ERP employee account across browsers and devices; Administrators can view all claims

### Project Track

- Sales can import an E3 Solar Proposal PDF or create a project manually
- Proposal import extracts the Sales representative, Proposal Number, customer details, system items, expected deposit and printed Balance Due
- Six-stage Kanban: Deposit Not Paid, Material Delivery, Installing, Installed / Waiting COES, STC Rebate and Done
- Sales uploads deposit proof or confirms payment without a file; Admin confirms the actual amount received, including zero
- Project Managers schedule material delivery, mark delivery and installation complete, and confirm COES receipt
- After delivery, Sales marks the customer payment as received without uploading a file; Admin records the actual amount before installation begins
- Applicable Solar and Battery STC receipts are confirmed separately before completion
- Installed / Waiting COES, STC Rebate and Done projects support repeatable Sales payment acknowledgements followed by Admin amount confirmation; partial or zero receipts remain collectible until the Amount Due reaches zero
- Only the initial deposit requires a payment screenshot or PDF; every successful workflow action closes Project Details
- Cards show the live remaining Amount Due, while Project Details retains the original proposal, every proof and the final-payment ledger
- Administrators can override a stage completed outside ERP only with a reason and a current project version; pending payment reviews cannot be bypassed
- Project Details includes a read-only Activity history with the actor, time, action and override details

Project Track starts from the signed-in employee role. PM and Sales accounts cannot switch roles; Administrator accounts can cover Sales and PM workflow steps. The API verifies the signed-in role instead of trusting the role submitted by the browser.

### Reports

- A simple shared needs editor opened from the sidebar footer
- The first line reads “Make life easier，Let me know your needs”
- Users can write requests below it and changes save automatically
- Save status, last-saved time, character count and keyboard save shortcut

Finance remains visible as a disabled future module. The optional MCP implementation remains available for integrations outside the Home Agent.

## Delivery data flow

```text
Inventory New Order
      | submits reserved items and delivery request
      v
Project Management: Pending PM Review
      |
      | PM assigns date and driver
      v
Scheduled / Today
      | confirm delivery
      v
Delivered + Inventory history
```

The project board does not duplicate orders. The Inventory order status is the source of truth: pending orders are awaiting PM review, while scheduled orders appear in Scheduled or Today.

## Local development

Node.js 20 or later is required.

```bash
npm install
npm run dev
```

Open the exact local URL printed by Next.js. The default is `http://localhost:3000`; if that port is occupied, Next.js selects another port such as `http://localhost:3001`.

Production validation:

```bash
npm run typecheck
npm test
npm run build
npm start
```

Cloudflare Workers deployment is preconfigured with OpenNext. See [CLOUDFLARE_DEPLOYMENT.md](./CLOUDFLARE_DEPLOYMENT.md) for the GitHub import settings, required secrets and persistent-storage configuration.

## Service configuration

Copy `.env.example` to `.env.local`. These upstream addresses are server-only and are not included in the browser bundle:

```dotenv
INVENTORY_OPERATIONS_API_URL=https://inventory.e3energy.com.au/api/inventory
QUOTEHELP_APP_URL=https://quote.e3energy.com.au
ERP_INTERNAL_API_TOKEN=
ERP_AUTH_SESSION_SECRET=
AGENT_API_KEY=
AGENT_BASE_URL=https://navigator-spongy-diagnosis.ngrok-free.dev/v1
AGENT_MODEL=qwen3.5:9b
AGENT_ALLOWED_API_HOSTS=
AGENT_SETTINGS_DATA_DIR=
GROUP_CHAT_DATA_DIR=
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com/beta
DEEPSEEK_MODEL_FAST=deepseek-v4-flash
DEEPSEEK_MODEL_COMPLEX=deepseek-v4-pro
```

- `/api/inventory/operations` accepts only approved Inventory actions and uses a fixed upstream address.
- `/api/quotehelp/*` exposes only the login, session, settings, quotation and import paths used by the native module.
- Both proxies limit body size, connection time and browser request origin.
- Upstream cookies are placed in separate ERP namespaces with restricted paths. ERP, Clerk and other application cookies are never forwarded to external business services.
- Browser writes require both a valid employee session and a verifiably same-origin request. Trusted server writes require the `ERP_INTERNAL_API_TOKEN` bearer token.
- QuoteHelp Excel uploads are limited to 25 MiB; Inventory JSON operations are limited to 512 KiB.
- Agent and Agent Settings writes are same-origin protected and body-size limited. Local development stores the optional API key in a private `0700` directory using an atomic `0600` file; Cloudflare production stores saved settings in server-side D1. The key is returned only as a masked configured state, and a Cloudflare Secret remains preferred for production credentials.
- Administrators can add or replace the DeepSeek API key under **Settings → Agent Settings → DeepSeek Business Agent**. Leaving the key blank preserves the saved key; removing saved settings deletes it. The read-only Business Agent uses this saved configuration before environment fallback.
- The model connection is restricted to approved HTTPS hosts. Model tools strictly validate their arguments and return bounded, sanitised, read-only records.

The unified read-only APIs use the live Inventory Operations service and the authenticated QuoteHelp session. An explicit quotation API can optionally replace the QuoteHelp session source:

```dotenv
ERP_INVENTORY_API_URL=
ERP_QUOTATION_API_URL=
ERP_API_TOKEN=
ERP_KNOWLEDGE_API_URL=
ERP_PROJECT_API_URL=
ERP_ORDER_API_URL=
```

When these overrides are empty, Inventory uses `INVENTORY_OPERATIONS_API_URL` and Quotations uses `QUOTEHELP_APP_URL`. Live-source failures are fail-closed: demo data is never substituted into Agent, Dashboard, Inventory or Quotations responses. After this change, users with an existing QuoteHelp login may need to sign in to QuoteHelp once more so its namespaced session cookie is available to the unified read-only routes.

Agent source health and evals:

```bash
# Authenticated health check (in the signed-in application)
GET /api/agent/health

# Run seven live deterministic business evals against a running deployment
E3_EVAL_BASE_URL=http://localhost:3000 E3_EVAL_COOKIE='your ERP session cookies' npm run eval:agent
```

The eval runner uses live business sources and checks workflow selection plus answer availability. It does not store business records in the repository.

Reimbursements use local private storage by default:

```dotenv
REIMBURSEMENT_DATA_DIR=
REIMBURSEMENT_ADMIN_PASSWORD=
REIMBURSEMENT_SESSION_SECRET=
REPORTS_DATA_DIR=
PAYMENT_TRACK_DATA_DIR=
SITE_VISIT_DATA_DIR=
```

Local development includes the legacy Admin demo password `admin` for the module-specific fallback. Production employee login requires `ERP_AUTH_SESSION_SECRET` with at least 32 random characters. Cloudflare production uses D1 for employee accounts and the app's other structured records, plus private Workers KV for Files blobs, Project Track files, Site Visiting photos and Reimbursement invoices; local development retains the `.data` fallback. Administrators manage employees under **Settings → User Management**. Account changes increment a server-checked session version, immediately invalidating that employee's existing sessions.

Project Track rejects repeated Proposal Numbers across both PDF imports and manual projects. The comparison ignores letter case and surrounding whitespace, and duplicate attempts return a conflict without creating another project or contract file.

## Web APIs

| Route | Purpose |
| --- | --- |
| `POST /api/auth/login` | Validate an employee account and create a signed session |
| `GET /api/auth/session` | Return the current employee identity and role |
| `POST /api/auth/logout` | Clear the employee session |
| `GET/POST /api/settings/users` | List or create employee accounts as Administrator |
| `PATCH /api/settings/users/:username` | Change an employee's name, role, status or password as Administrator |
| `GET/POST /api/inventory/operations` | Controlled proxy for native Inventory and delivery operations |
| `GET/POST/PUT/DELETE /api/quotehelp/*` | Controlled proxy for native QuoteHelp operations |
| `GET /api/files` | Browse, search and inspect the shared Files workspace or Trash |
| `POST /api/files/folders` | Create a folder as the signed-in employee |
| `POST /api/files/upload` | Upload one validated file up to 20 MiB |
| `PATCH/DELETE /api/files/items/:id` | Rename, move, trash, restore or Admin-purge an item |
| `GET /api/files/items/:id/content` | Protected preview or download of a stored file |
| `GET /api/inventory` | Unified read-only inventory list |
| `GET /api/quotations` | Unified read-only quotation list |
| `GET /api/dashboard` | Home inventory, alert and quotation summary |
| `GET/POST /api/announcements` | List public announcements or publish one as Administrator |
| `PATCH/DELETE /api/announcements/:id` | Update or remove a public announcement as Administrator |
| `GET/PUT /api/reports` | Load and automatically save the shared needs document |
| `GET/POST/PATCH /api/reimbursements` | Private claim list, invoice submission and admin status actions |
| `DELETE /api/reimbursements/:id` | Permanently remove a claim and its invoice as Administrator |
| `GET/POST/DELETE /api/reimbursements/admin` | Reimbursement Admin session |
| `GET /api/reimbursements/:id/invoice` | Protected invoice viewing |
| `GET/POST /api/payment-track` | List projects or create a manual project in Project Track |
| `POST /api/payment-track/import` | Import and extract an E3 Solar Proposal PDF |
| `PATCH/DELETE /api/payment-track/:id` | Apply an authorised workflow transition or permanently remove a project as Administrator |
| `POST /api/payment-track/:id/proof` | Upload the initial deposit proof |
| `GET/POST/DELETE /api/payment-track/admin` | Project Track Admin session |
| `GET /api/payment-track/:id/files/:fileId` | Protected proposal or proof viewing |
| `GET/POST /api/site-visits` | List and create scheduled site visits |
| `GET/PATCH/DELETE /api/site-visits/:id` | View or update a site visit; permanent deletion requires Administrator access |
| `POST /api/site-visits/:id/photos` | Upload site photos from a camera or photo library |
| `GET/DELETE /api/site-visits/:id/photos/:photoId` | View or remove a protected site photo |
| `GET/POST /api/project-schedule` | List or create custom Weekly Schedule jobs |
| `PATCH/DELETE /api/project-schedule/:id` | Update a custom job or permanently remove it as Administrator |
| `POST /api/agent` | OpenAI-compatible model-backed read-only questions across ERP workspaces, with a local fallback |
| `POST /api/agent/chat` | Strict read-only Business Agent for inventory, cited knowledge, project snapshots and order finance |
| `GET /api/agent/health` | Verify all seven E3 Agent business data sources without returning business records |
| `GET/PUT/DELETE /api/settings/agent` | Masked Agent configuration, secure save and environment fallback |

## MCP Server

`mcp-server` retains six read-only tools: inventory list, inventory item, low stock, quotation list, quotation detail and ERP summary. It requires `ERP_WORKSPACE_API_URL` plus the matching internal token, has no demo fallback, and cannot dispatch, reschedule, delete or confirm delivery. MCP quotation tools also require the workspace to configure `ERP_QUOTATION_API_URL`, because a server-to-server MCP process cannot reuse an employee's browser-only QuoteHelp session.

```bash
cd mcp-server
npm install
npm run build
npm start
```

See `mcp-server/README.md` for details.

## Project structure

```text
src/components/erp-workspace.tsx                  Authenticated ERPNext-style application shell
src/components/files-workspace.tsx                Shared folder and file workspace
src/app/login/                                    Mobile-first employee sign-in
src/app/api/auth/                                 Employee login, session and logout APIs
src/app/api/settings/users/                       Administrator-only employee management APIs
src/app/api/files/                                Folder, upload, item and protected-content APIs
src/lib/auth/                                     Account verifiers, roles and signed session handling
src/lib/workspace-files/                          File metadata, storage and request validation
src/middleware.ts                                 Cloudflare-compatible global page/API authentication boundary
src/components/inventory-operations-workspace.tsx Native Inventory module
src/components/quotehelp-workspace.tsx            Native quotation module
src/components/project-delivery-board.tsx         Project delivery Kanban
src/components/payment-track-workspace.tsx        Accounts receivable workflow Kanban
src/components/site-visiting-workspace.tsx        Mobile-first site visit scheduling and field capture
src/components/reimbursement-workspace.tsx        Reimbursements workspace
src/components/reports-workspace.tsx               Auto-saving needs editor
src/app/api/inventory/operations/                 Controlled Inventory proxy
src/app/api/quotehelp/                             Controlled QuoteHelp proxy
src/app/api/reimbursements/                        Claim, admin and invoice APIs
src/app/api/payment-track/                         Payment workflow, import, proof and file APIs
src/app/api/reports/                               Reports document API
src/app/api/settings/agent/                        Secure Agent model configuration API
src/lib/agent/                                     Model client, settings storage and bounded ERP tools
src/lib/payment-track/                             Payment state machine, storage and PDF extraction
src/lib/site-visits/                               Site visit records, checklist and photo storage
src/lib/quotehelp/                                 Quotation domain and Excel logic
src/lib/inventory-operations/                      Inventory types and order grouping
mcp-server/                                        Optional read-only MCP Server
```

## Production security requirements

The current version includes a unified D1-backed employee identity and role system. Before broader external production access:

1. Consider company SSO or Clerk later if central identity-provider onboarding, MFA or self-service password recovery is required.
2. Confirm detailed per-module permissions beyond the enforced Project Track roles; hidden buttons are not authorisation.
3. Add distributed login rate limits, audit logs and operational alerts.
4. Confirm that the upstream Inventory and QuoteHelp cookie policies match the final HTTPS ERP domain.
5. Preserve explicit confirmation and traceability for deletion, stock loss, delivery cancellation and delivery completion.
6. Validate email delivery, Excel import and real stock deductions in a staging environment before switching the production domain.
